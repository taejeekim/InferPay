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

test("an empty ledger and a ledger that skips payment are corrupt", () => {
  assert.equal(fold([]).ok, false);
  const world = fixture();
  const settledFirst: JobEvent = {
    type: "payment-settled",
    at: world.at,
    receipt: world.receipt,
  };
  assert.equal(fold([settledFirst]).ok, false);
  const ratedTwice = fold([...happy(world), rated(world, 4), rated(world, 5)]);
  assert.equal(ratedTwice.ok, false);
});

test("fold walks crash points and plan names the missing step", () => {
  const world = fixture();
  const open = fold([opened(world)]);
  assert.equal(open.ok, true);
  if (!open.ok) return;
  assert.equal(open.state.phase, "open");
  assert.equal(plan(open.state).kind, "intend-payment");

  const paying = fold([opened(world), intended(world)]);
  assert.equal(paying.ok, true);
  if (!paying.ok || paying.state.phase !== "paying") return;
  const settle = plan(paying.state);
  assert.equal(settle.kind, "settle");
  if (settle.kind !== "settle") return;
  assert.equal(settle.transfer.key, world.key);

  const pending = fold([opened(world), intended(world), pendingEvent(world)]);
  assert.equal(pending.ok, true);
  if (!pending.ok || pending.state.phase !== "paying") return;
  assert.equal(pending.state.correlationId, world.correlation);
  assert.equal(plan(pending.state).kind, "settle");

  const paid = fold([opened(world), intended(world), settled(world)]);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  assert.equal(paid.state.phase, "paid");
  assert.equal(plan(paid.state).kind, "fulfil");

  const retrying = fold([opened(world), intended(world), settled(world), failed(world, true)]);
  assert.equal(retrying.ok, true);
  if (!retrying.ok || retrying.state.phase !== "paid") return;
  assert.equal(retrying.state.failures.length, 1);
  assert.equal(plan(retrying.state).kind, "fulfil");

  const exhausted = fold([
    opened(world),
    intended(world),
    settled(world),
    failed(world, true),
    failed(world, true),
    failed(world, true),
  ]);
  assert.equal(exhausted.ok, true);
  if (!exhausted.ok) return;
  const stop = plan(exhausted.state);
  assert.equal(stop.kind, "stop");
  if (stop.kind !== "stop") return;
  assert.equal(stop.reason.kind, "provider-failed");

  const abandoned = fold([opened(world), intended(world), settled(world), failed(world, false)]);
  assert.equal(abandoned.ok, true);
  if (!abandoned.ok) return;
  assert.equal(abandoned.state.phase, "abandoned");

  const done = fold([...throughPaid(world), fulfilled(world)]);
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(plan(done.state).kind, "done");

  const scored = fold([...throughPaid(world), fulfilled(world), rated(world, 4)]);
  assert.equal(scored.ok, true);
  if (!scored.ok) return;
  assert.equal(scored.state.phase, "rated");
  assert.equal(plan(scored.state).kind, "done");
});

test("a settled receipt must match the key, the recipient, and the quote", () => {
  const world = fixture();
  const otherKey = must(parseIdempotencyKey("other-key"), "key");
  const otherPay = must(parseAccountId("legal.stella.inferpay.near"), "recipient");
  const otherAmount = must(parseDecimalAmount("0.03"), "amount");
  const matching = fold([opened(world), intended(world), settled(world)]);
  assert.equal(matching.ok, true);
  assert.equal(fold([
    opened(world),
    intended(world),
    { type: "payment-settled", at: world.at, receipt: { ...world.receipt, key: otherKey } },
  ]).ok, false);
  assert.equal(fold([
    opened(world),
    intended(world),
    { type: "payment-settled", at: world.at, receipt: { ...world.receipt, recipient: otherPay } },
  ]).ok, false);
  assert.equal(fold([
    opened(world),
    intended(world),
    { type: "payment-settled", at: world.at, receipt: { ...world.receipt, amount: { ...world.quote, amount: otherAmount } } },
  ]).ok, false);
  assert.equal(fold([
    opened(world),
    intended(world),
    { type: "payment-settled", at: world.at, receipt: { ...world.receipt, amount: { ...world.quote, symbol: "USD" } } },
  ]).ok, false);
});

test("reputation counts finished jobs and averages only ratings", () => {
  const world = fixture();
  const completed = state(fold([...throughPaid(world), fulfilled(world)]));
  const ratedJob = state(fold([...throughPaid(world), fulfilled(world), rated(world, 4)]));
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
    offer: price(quote),
    budget: price(budget),
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
  const receipt: PaymentReceipt = { key, correlationId: correlation, amount: price(quote), recipient: payTo, rail: "mock" };
  const answer: Answer = {
    text: "Operating profit matches across both documents: KRW 12.2T.",
    checks: [],
    model,
    inference: "stub",
    attestation: [],
  };
  return { order, quote: price(quote), payTo, key, correlation, at, receipt, answer };
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

function fulfilled(world: ReturnType<typeof fixture>): JobEvent {
  return { type: "fulfilled", at: world.at, answer: world.answer };
}

function rated(world: ReturnType<typeof fixture>, stars: 1 | 2 | 3 | 4 | 5): JobEvent {
  return { type: "rated", at: world.at, rating: must(parseStars(stars), "stars") };
}

function throughPaid(world: ReturnType<typeof fixture>): JobEvent[] {
  return [opened(world), intended(world), settled(world)];
}

function happy(world: ReturnType<typeof fixture>): JobEvent[] {
  return [...throughPaid(world), fulfilled(world), rated(world, 4)];
}

function must<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(label);
  return value;
}
