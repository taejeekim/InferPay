import assert from "node:assert/strict";
import test from "node:test";
import { matchCommitment, matchRating, matchRatingTx, matchTransfer } from "./match.ts";

const transfer = { what: "payment", hash: "HASH", signer: "bot.testnet", receiver: "shop.testnet", near: "0.02" };

function chainTransfer(over: { signer?: string; receiver?: string; deposit?: string; status?: unknown } = {}) {
  return {
    transaction: {
      signer_id: over.signer ?? "bot.testnet",
      receiver_id: over.receiver ?? "shop.testnet",
      actions: [{ Transfer: { deposit: over.deposit ?? "20000000000000000000000" } }],
    },
    status: over.status ?? { SuccessValue: "" },
  };
}

test("a transfer matches only when signer, receiver, amount, and success all agree with the chain", () => {
  assert.equal(matchTransfer(transfer, chainTransfer()).ok, true);
  assert.match(matchTransfer(transfer, chainTransfer({ receiver: "other.testnet" })).detail, /receiver is other\.testnet/);
  assert.match(matchTransfer(transfer, chainTransfer({ signer: "x.testnet" })).detail, /signer is x\.testnet/);
  assert.match(matchTransfer(transfer, chainTransfer({ deposit: "19500000000000000000000" })).detail, /deposit is 195/);
  assert.match(matchTransfer(transfer, chainTransfer({ status: { Failure: {} } })).detail, /did not succeed/);
  assert.match(matchTransfer(transfer, null).detail, /unknown to the chain/);
});

test("a commitment matches only when the root on chain equals the root recomputed locally", () => {
  const local = { scheme: "inferpay-keyed-merkle-sha256-v1", root: "a".repeat(64), leaves: 3 } as Parameters<typeof matchCommitment>[1];
  const published = (root: string) => ({ "shop.testnet": { inferpay: { commitment: JSON.stringify({ ...local, root }) } } });
  assert.equal(matchCommitment("shop.testnet", local, published("a".repeat(64))).ok, true);
  assert.equal(matchCommitment("shop.testnet", local, published("b".repeat(64))).ok, false);
  assert.match(matchCommitment("shop.testnet", local, {}).detail, /no commitment on chain/);
});

test("a rating matches only when its transaction called set on SocialDB and the stored rating names the same payment", () => {
  const rating = { hash: "R", rater: "bot.testnet", jobId: "job_1", shop: "shop.testnet", stars: 5, payment: "PAY" };
  const call = (receiver: string, method: string) => ({
    transaction: { signer_id: "bot.testnet", receiver_id: receiver, actions: [{ FunctionCall: { method_name: method } }] },
    status: { SuccessValue: "" },
  });
  assert.equal(matchRatingTx(rating, "social.testnet", call("social.testnet", "set")).ok, true);
  assert.equal(matchRatingTx(rating, "social.testnet", call("elsewhere.testnet", "set")).ok, false);
  assert.equal(matchRatingTx(rating, "social.testnet", call("social.testnet", "get")).ok, false);
  const stored = (payment: string | null) => ({
    "bot.testnet": { inferpay: { ratings: { job_1: JSON.stringify({ shop: "shop.testnet", stars: 5, payment, verified: 1, forged: 0 }) } } },
  });
  assert.equal(matchRating(rating, stored("PAY")).ok, true);
  assert.equal(matchRating(rating, stored("OTHER")).ok, false);
  assert.match(matchRating(rating, {}).detail, /no rating on chain/);
  const unpaid = { ...rating, stars: 1, payment: null };
  const storedUnpaid = { "bot.testnet": { inferpay: { ratings: { job_1: JSON.stringify({ shop: "shop.testnet", stars: 1, payment: null, verified: 1, withheld: 1, forged: 1 }) } } } };
  assert.equal(matchRating(unpaid, storedUnpaid).ok, true);
  assert.match(matchRating(unpaid, storedUnpaid).what, /nothing paid/);
  assert.equal(matchRating(unpaid, stored("PAY")).ok, false);
});
