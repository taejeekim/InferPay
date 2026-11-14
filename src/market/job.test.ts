import assert from "node:assert/strict";
import test from "node:test";
import {
  newJobId,
  parseAccountId,
  parseAssetId,
  parseCorrelationId,
  parseDecimalAmount,
  parseIdempotencyKey,
  parseIsoTime,
  parseModelId,
  parseProviderId,
  parseStars,
  type Price,
} from "../domain.ts";
import { parseCommitment, SCHEME } from "../commitment/index.ts";
import type { PaymentReceipt } from "../payment/index.ts";
import type { Answer } from "../providers/types.ts";
import { fold, plan, reputationOf, type JobEvent, type JobState, type Order } from "./job.ts";

test("an empty ledger, a payment before delivery, and a second rating are corrupt", () => {
  assert.equal(fold([]).ok, false);
  const world = fixture();
  assert.equal(fold([settled(world)]).ok, false);
  assert.equal(fold([opened(world), intended(world)]).ok, false, "no payment before the delivery and its payout");
  assert.equal(fold([opened(world), delivered(world), intended(world)]).ok, false, "no payment before the payout is decided");
  assert.equal(fold([opened(world), payout(world, "0.02", 1, 1)]).ok, false, "no payout before delivery");
  assert.equal(fold([...happy(world), rated(world, 5)]).ok, false);
});

test("fold walks every crash point in deliver, verify, pay order and plan names the missing step", () => {
  const world = fixture();
  const steps: readonly [readonly JobEvent[], JobState["phase"], string][] = [
    [[opened(world)], "awaiting-delivery", "fulfil"],
    [[opened(world), failed(world, true)], "awaiting-delivery", "fulfil"],
    [[opened(world), delivered(world)], "delivered", "decide-payout"],
    [throughPayout(world), "payable", "intend-payment"],
    [[...throughPayout(world), intended(world)], "paying", "settle"],
    [[...throughPayout(world), intended(world), pendingEvent(world)], "paying", "settle"],
    [throughSettled(world), "settled", "done"],
    [happy(world), "rated", "done"],
  ];
  for (const [events, phase, effect] of steps) {
    const folded = state(fold(events));
    assert.equal(folded.phase, phase, events.map((event) => event.type).join(" > "));
    assert.equal(plan(folded).kind, effect, phase);
  }
  const paying = state(fold([...throughPayout(world), intended(world), pendingEvent(world)]));
  const settle = plan(paying);
  assert.ok(settle.kind === "settle" && paying.phase === "paying");
  assert.equal(paying.correlationId, world.correlation);
  assert.deepEqual(settle.transfer, { jobId: world.order.jobId, key: world.key, payer: world.order.payFrom, amount: world.quote, recipient: world.payTo });

  const exhausted = state(fold([opened(world), failed(world, true), failed(world, true), failed(world, true)]));
  assert.deepEqual(plan(exhausted), { kind: "stop", reason: { kind: "provider-failed", reason: "transport" } });
  assert.equal(state(fold([opened(world), failed(world, false)])).phase, "abandoned");
  assert.equal(fold([opened(world), delivered(world), failed(world, true)]).ok, false, "a delivered job never asks the shop again");
});

test("a forged delivery settles unpaid: no transfer is ever planned, and only a rating can follow", () => {
  const world = fixture();
  const forged: JobEvent = { type: "payout-decided", at: world.at, payout: { amount: world.price("0"), basis: { kind: "forged", forged: 1 } } };
  const unpaid = state(fold([opened(world), delivered(world), forged]));
  assert.ok(unpaid.phase === "settled");
  assert.deepEqual(unpaid.settlement, { kind: "unpaid" });
  assert.equal(plan(unpaid).kind, "done");
  assert.equal(fold([opened(world), delivered(world), forged, intended(world)]).ok, false);
  assert.equal(state(fold([opened(world), delivered(world), forged, rated(world, 1)])).phase, "rated");
  const paidForgery: JobEvent = { type: "payout-decided", at: world.at, payout: { amount: world.quote, basis: { kind: "forged", forged: 1 } } };
  assert.equal(fold([opened(world), delivered(world), paidForgery]).ok, false, "a forged payout above zero is corrupt");
});

test("a payout never exceeds the agreed price, and a partial payout is what the transfer carries", () => {
  const world = fixture();
  assert.equal(fold([opened(world), delivered(world), payout(world, "0.03", 1, 1)]).ok, false);
  assert.equal(fold([opened(world), delivered(world), payout(world, "0.01", 3, 2)]).ok, false);
  const half = state(fold([opened(world), delivered(world), payout(world, "0.01", 1, 2), intended(world)]));
  const effect = plan(half);
  assert.ok(effect.kind === "settle");
  assert.equal(effect.transfer.amount.amount, "0.01");
  const fullReceipt: JobEvent = { type: "payment-settled", at: world.at, receipt: world.receipt };
  assert.equal(fold([opened(world), delivered(world), payout(world, "0.01", 1, 2), intended(world), fullReceipt]).ok, false, "the receipt must carry the payout");
});

test("a settled receipt must match the key, the recipient, and the quote", () => {
  const world = fixture();
  const otherKey = must(parseIdempotencyKey("other-key"), "key");
  const otherPay = must(parseAccountId("legal.stella.inferpay.near"), "recipient");
  const otherAmount = must(parseDecimalAmount("0.03"), "amount");
  const matching = fold([...throughPayout(world), intended(world), settled(world)]);
  assert.equal(matching.ok, true);
  assert.equal(fold([
    ...throughPayout(world),
    intended(world),
    { type: "payment-settled", at: world.at, receipt: { ...world.receipt, key: otherKey } },
  ]).ok, false);
  assert.equal(fold([
    ...throughPayout(world),
    intended(world),
    { type: "payment-settled", at: world.at, receipt: { ...world.receipt, recipient: otherPay } },
  ]).ok, false);
  assert.equal(fold([
    ...throughPayout(world),
    intended(world),
    { type: "payment-settled", at: world.at, receipt: { ...world.receipt, amount: { ...world.quote, amount: otherAmount } } },
  ]).ok, false);
  assert.equal(fold([
    ...throughPayout(world),
    intended(world),
    { type: "payment-settled", at: world.at, receipt: { ...world.receipt, amount: { ...world.quote, symbol: "USD" } } },
  ]).ok, false);
});

test("reputation counts finished jobs and averages only ratings", () => {
  const world = fixture();
  const completed = state(fold(throughSettled(world)));
  const ratedJob = state(fold(happy(world)));
  const open = state(fold([opened(world)]));
  assert.deepEqual(reputationOf([open, completed]), { kind: "unrated", completedJobs: 1 });
  assert.deepEqual(reputationOf([completed, ratedJob]), {
    kind: "rated",
    completedJobs: 2,
    ratings: 1,
    average: 4,
  });
  assert.deepEqual(reputationOf([]), { kind: "unrated", completedJobs: 0 });
});

function state(result: ReturnType<typeof fold>): JobState {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected a folded job");
  return result.state;
}

function fixture() {
  const asset = must(parseAssetId("nep141:wrap.near"), "asset");
  const quote = must(parseDecimalAmount("0.02"), "quote");
  const budget = must(parseDecimalAmount("0.10"), "budget");
  const price = (amount: typeof quote): Price => ({ asset, symbol: "NEAR", amount });
  const order: Order = {
    jobId: newJobId(1_700_000_000_000),
    providerId: must(parseProviderId("disclosure"), "provider"),
    question: "Does the filing match?",
    needs: [{ kind: "fact", topic: "operating-profit" }],
    offer: price(quote),
    budget: price(budget),
    reserve: { paymentGas: "0", ratingGas: "0", ratingStorage: "0", firstRating: false },
    payFrom: must(parseAccountId("researcher.kyle.inferpay.near"), "payFrom"),
    commitment: {
      status: "published",
      commitment: must(parseCommitment({ scheme: SCHEME, root: "ab".repeat(32), leaves: 1 }), "commitment"),
      source: { kind: "listing" },
    },
  };
  const key = must(parseIdempotencyKey("mock_key"), "key");
  const correlation = must(parseCorrelationId("mock-7f3a"), "correlation");
  const at = must(parseIsoTime("2026-10-24T14:02:11.000Z"), "time");
  const payTo = must(parseAccountId("disclosure.david.inferpay.near"), "payTo");
  const model = must(parseModelId("stub"), "model");
  const receipt: PaymentReceipt = { key, correlationId: correlation, amount: price(quote), recipient: payTo, rail: "mock", feeYocto: null };
  const answer: Answer = {
    text: "Operating profit matches across both documents: KRW 12.2T.",
    checks: [],
    model,
    inference: "stub",
    attestation: [],
  };
  const decimal = (amount: string): Price => price(must(parseDecimalAmount(amount), amount));
  return { order, quote: price(quote), price: decimal, payTo, key, correlation, at, receipt, answer };
}

function opened(world: ReturnType<typeof fixture>): JobEvent {
  return { type: "opened", at: world.at, order: world.order, quote: world.quote, payTo: world.payTo };
}

function intended(world: ReturnType<typeof fixture>): JobEvent {
  return { type: "payment-intended", at: world.at, key: world.key };
}

function pendingEvent(world: ReturnType<typeof fixture>): JobEvent {
  return { type: "payment-pending", at: world.at, correlationId: world.correlation, uncertain: true };
}

function settled(world: ReturnType<typeof fixture>): JobEvent {
  return { type: "payment-settled", at: world.at, receipt: world.receipt };
}

function failed(world: ReturnType<typeof fixture>, retryable: boolean): JobEvent {
  return { type: "fulfil-failed", at: world.at, reason: "transport", retryable };
}

function delivered(world: ReturnType<typeof fixture>): JobEvent {
  return { type: "delivered", at: world.at, answer: world.answer };
}

function payout(world: ReturnType<typeof fixture>, amount: string, proven: number, needed: number): JobEvent {
  return { type: "payout-decided", at: world.at, payout: { amount: world.price(amount), basis: { kind: "share", proven, needed } } };
}

function rated(world: ReturnType<typeof fixture>, stars: 1 | 2 | 3 | 4 | 5): JobEvent {
  return { type: "rated", at: world.at, rating: must(parseStars(stars), "stars") };
}

function throughPayout(world: ReturnType<typeof fixture>): JobEvent[] {
  return [opened(world), delivered(world), payout(world, "0.02", 1, 1)];
}

function throughSettled(world: ReturnType<typeof fixture>): JobEvent[] {
  return [...throughPayout(world), intended(world), settled(world)];
}

function happy(world: ReturnType<typeof fixture>): JobEvent[] {
  return [...throughSettled(world), rated(world, 4)];
}

function must<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(label);
  return value;
}
