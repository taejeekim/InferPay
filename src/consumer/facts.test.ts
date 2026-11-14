import assert from "node:assert/strict";
import test from "node:test";
import { factKey, sealDataset, type AssertedCheck, type Fact, type Need, type PinnedCommitment, type Rule } from "../commitment/index.ts";
import { parseHash } from "../commitment/merkle.ts";
import { factText } from "../cli/render.ts";
import { provenFacts } from "./facts.ts";
import { verifyChecks } from "./verify.ts";

const COPAY: Fact = { kind: "fact", topic: "mri-copay", value: "20", source: "Policy schedule §4.2" };
const INDEMNITY: Rule = { kind: "rule", id: "uncapped", all: ["unlimited", "indemn"], label: "uncapped indemnity", detail: "cap it at fees paid" };
const SHOP = sealDataset([COPAY, INDEMNITY].map((entry, index) => ({ entry, salt: must(parseHash(`0${index + 1}`.repeat(32))) })));
const PINNED: PinnedCommitment = { status: "published", commitment: SHOP.commitment, source: { kind: "listing" } };
const QUESTION = "What MRI copay applies, and does our unlimited indemnification clause pass the playbook?";
const NEED_COPAY: Need = { kind: "fact", topic: "mri-copay" };
const NEED_RULE: Need = { kind: "rule", id: "uncapped", clause: "unlimited indemnification clause" };
const NEED_DENTAL: Need = { kind: "fact", topic: "dental" };

function copay(claimed: string): AssertedCheck {
  return { kind: "fact", claim: { label: "MRI copay", topic: "mri-copay", claimed }, verdict: claimed === "20" ? "match" : "mismatch", evidence: SHOP.prove(COPAY) };
}

function lines(needs: readonly Need[], ...checks: readonly AssertedCheck[]): string[] {
  return provenFacts(verifyChecks(checks, PINNED, QUESTION, needs), needs).map(factText);
}

test("the buyer's facts come from the verified entry, never from the shop's prose or its claim", () => {
  // A summary saying 10 percent changes nothing: the answer text never reaches the facts.
  assert.deepEqual(lines([NEED_COPAY], copay("20")), ["= 20"]);
  assert.deepEqual(lines([NEED_COPAY], copay("10")), ["= 20"], "a mismatched claim still yields the true value");
});

test("a withheld or forged key gives no value, an empty slot says so, and a rule says whether it applies to the quoted clause", () => {
  assert.deepEqual(lines([NEED_COPAY]), ["not proven: no verified opening, so the buyer has no value for it"]);
  const forged: AssertedCheck = { kind: "fact", claim: { label: "MRI copay", topic: "mri-copay", claimed: "10" }, verdict: "match", evidence: SHOP.prove(COPAY) };
  assert.deepEqual(lines([NEED_COPAY], forged), ["not proven: no verified opening, so the buyer has no value for it"]);
  const empty: AssertedCheck = { kind: "opening", key: factKey(NEED_DENTAL), verdict: "unverifiable", evidence: SHOP.proveAbsent(factKey(NEED_DENTAL)) };
  assert.deepEqual(lines([NEED_DENTAL], empty), ["the shop proved it holds nothing for this key"]);
  const flag: AssertedCheck = {
    kind: "flag",
    claim: { label: "indemnity", text: "unlimited indemnification clause", rule: "uncapped" },
    verdict: "raised",
    evidence: SHOP.prove(INDEMNITY),
  };
  assert.deepEqual(lines([NEED_RULE], flag), ["applies to the quoted clause"]);
});

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
