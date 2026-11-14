import assert from "node:assert/strict";
import test from "node:test";
import { factKey, sealDataset, type AssertedCheck, type Fact, type Need } from "../commitment/index.ts";
import { parseHash } from "../commitment/merkle.ts";
import { newJobId, parseAccountId, parseAssetId, parseDecimalAmount, parseModelId, parseProviderId, type Price } from "../domain.ts";
import type { Order } from "../market/index.ts";
import { payoutFor } from "./payout.ts";

const MRI: Fact = { kind: "fact", topic: "outpatient-mri", value: "covered", source: "schedule 4.2" };
const COPAY: Fact = { kind: "fact", topic: "mri-copay", value: "20", source: "schedule 4.2" };
const DEDUCTIBLE: Fact = { kind: "fact", topic: "deductible", value: "500", source: "schedule 1.1" };
const SHOP = sealDataset([MRI, COPAY, DEDUCTIBLE].map((entry, index) => ({ entry, salt: must(parseHash(`0${index + 1}`.repeat(32))) })));
const NEEDS: readonly Need[] = [MRI, COPAY, DEDUCTIBLE].map((fact) => ({ kind: "fact", topic: fact.topic }));

function claim(entry: Fact, claimed: string): AssertedCheck {
  return { kind: "fact", claim: { label: entry.topic, topic: entry.topic, claimed }, verdict: claimed === entry.value ? "match" : "mismatch", evidence: SHOP.prove(entry) };
}

function paid(needs: readonly Need[], ...checks: readonly AssertedCheck[]): string {
  const order: Order = {
    jobId: newJobId(1_700_000_000_000),
    providerId: must(parseProviderId("insurance")),
    question: "What does this policy charge for an outpatient MRI?",
    needs,
    offer: price("0.02"),
    budget: price("0.10"),
    reserve: { paymentGas: "0", ratingGas: "0", ratingStorage: "0", firstRating: false },
    payFrom: must(parseAccountId("researcher.kyle.inferpay.testnet")),
    commitment: { status: "published", commitment: SHOP.commitment, source: { kind: "listing" } },
  };
  const answer = { text: "Covered.", checks, model: must(parseModelId("stub")), inference: "stub" as const, attestation: [] };
  return payoutFor({ order, quote: price("0.02") }, answer).amount.amount;
}

test("full delivery is paid in full, and a mismatch counts as opened because the buyer learned the true value", () => {
  assert.equal(paid(NEEDS, claim(MRI, "covered"), claim(COPAY, "20"), claim(DEDUCTIBLE, "500")), "0.02");
  assert.equal(paid(NEEDS, claim(MRI, "covered"), claim(COPAY, "10"), claim(DEDUCTIBLE, "500")), "0.02");
});

test("each withheld key costs its share of the price, rounded down to the smallest unit", () => {
  assert.equal(paid(NEEDS.slice(0, 2), claim(MRI, "covered")), "0.01");
  assert.equal(paid(NEEDS, claim(MRI, "covered")), "0.006666666666666666");
  assert.equal(paid(NEEDS), "0");
});

test("an empty slot is not paid for, so a shop cannot list keys it holds nothing for and be paid to prove so", () => {
  const dental: Need = { kind: "fact", topic: "dental" };
  const empty: AssertedCheck = { kind: "opening", key: factKey(dental), verdict: "unverifiable", evidence: SHOP.proveAbsent(factKey(dental)) };
  assert.equal(paid([NEEDS[0] ?? dental, dental], claim(MRI, "covered"), empty), "0.01");
});

test("one forged check voids the payout, whatever else was proven", () => {
  const forged: AssertedCheck = { kind: "fact", claim: { label: COPAY.topic, topic: COPAY.topic, claimed: "10" }, verdict: "match", evidence: SHOP.prove(COPAY) };
  assert.equal(paid(NEEDS, claim(MRI, "covered"), forged, claim(DEDUCTIBLE, "500")), "0");
});

function price(amount: string): Price {
  return { asset: must(parseAssetId("nep141:wrap.near")), symbol: "NEAR", amount: must(parseDecimalAmount(amount)) };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
