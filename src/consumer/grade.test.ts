import assert from "node:assert/strict";
import test from "node:test";
import { factKey, sealDataset, type AssertedCheck, type Fact, type PinnedCommitment } from "../commitment/index.ts";
import { parseHash } from "../commitment/merkle.ts";
import { grade, tally } from "./grade.ts";
import { verifyChecks } from "./verify.ts";

const COVERED: Fact = { kind: "fact", topic: "mri", value: "covered", source: "schedule" };
const SALT = parseHash("07".repeat(32));
if (!SALT) throw new Error("fixture salt");
const SHOP = sealDataset([{ entry: COVERED, salt: SALT }]);
const PINNED: PinnedCommitment = { status: "published", commitment: SHOP.commitment, source: { kind: "listing" } };
const DENTAL = { label: "dental", topic: "dental", claimed: "covered" };

const match: AssertedCheck = { kind: "fact", claim: { label: "MRI", topic: "mri", claimed: "covered" }, verdict: "match", evidence: SHOP.prove(COVERED) };
const mismatch: AssertedCheck = { kind: "fact", claim: { label: "MRI", topic: "mri", claimed: "excluded" }, verdict: "mismatch", evidence: SHOP.prove(COVERED) };
const absent: AssertedCheck = { kind: "fact", claim: DENTAL, verdict: "unverifiable", evidence: SHOP.proveAbsent(factKey(DENTAL)) };
const unbacked: AssertedCheck = { kind: "fact", claim: DENTAL, verdict: "unverifiable", evidence: null };
const clear: AssertedCheck = { kind: "flag", claim: { label: "term", text: "Twelve months." }, verdict: "clear", evidence: null };
const forged: AssertedCheck = {
  kind: "fact",
  claim: { label: "MRI", topic: "mri", claimed: "excluded" },
  verdict: "match",
  evidence: { ...SHOP.prove(COVERED), entry: { ...COVERED, value: "excluded" } },
};

function stars(...checks: readonly AssertedCheck[]): number {
  return grade(verifyChecks(checks, PINNED, "Is an MRI covered?"));
}

test("a verified mismatch costs one star and a verified match costs none", () => {
  assert.equal(stars(match), 5);
  assert.equal(stars(match, mismatch), 4);
  assert.equal(stars(mismatch, mismatch, mismatch, mismatch, mismatch, mismatch), 1);
});

test("an answer with nothing verified in its favour rates at most 3", () => {
  assert.equal(stars(), 3);
  assert.equal(stars(absent), 3);
  assert.equal(stars(unbacked), 3);
  assert.equal(stars(clear), 3);
  assert.equal(stars(clear, clear, clear), 3);
  assert.equal(stars(absent, unbacked, unbacked), 2);
});

test("a claim the shop does not back costs the same star as a mismatch, proven absent or not, so withholding never pays", () => {
  assert.equal(stars(match, unbacked), stars(match, mismatch));
  assert.equal(stars(match, absent), stars(match, mismatch));
  assert.equal(stars(match, clear), 5);
});

test("one forged check sets the rating to 1 whatever else was verified", () => {
  assert.equal(stars(match, match, forged), 1);
  assert.deepEqual(tally(verifyChecks([match, mismatch, absent, unbacked, clear, forged], PINNED, "Is an MRI covered?")), {
    verified: 3,
    mismatches: 1,
    unproven: 2,
    forged: 1,
    supporting: 2,
    unbacked: 2,
  });
});
