import assert from "node:assert/strict";
import test from "node:test";
import { factKey, sealDataset, type AssertedCheck, type Fact, type Need, type PinnedCommitment } from "../commitment/index.ts";
import { parseHash } from "../commitment/merkle.ts";
import { grade } from "./grade.ts";
import { verifyChecks } from "./verify.ts";

const MRI: Fact = { kind: "fact", topic: "outpatient-mri", value: "covered", source: "schedule 4.2" };
const COPAY: Fact = { kind: "fact", topic: "mri-copay", value: "20", source: "schedule 4.2" };
const COSMETIC: Fact = { kind: "fact", topic: "cosmetic-surgery", value: "excluded", source: "schedule 9.1" };
const SHOP = sealDataset([MRI, COPAY, COSMETIC].map((entry, index) => {
  const salt = parseHash(`0${index + 1}`.repeat(32));
  if (!salt) throw new Error("fixture salt");
  return { entry, salt };
}));
const PINNED: PinnedCommitment = { status: "published", commitment: SHOP.commitment, source: { kind: "listing" } };
const QUESTION = "What does this policy charge for an outpatient MRI?";

const NEED_MRI: Need = { kind: "fact", topic: "outpatient-mri" };
const NEED_COPAY: Need = { kind: "fact", topic: "mri-copay" };
const NEED_DENTAL: Need = { kind: "fact", topic: "dental" };

function claim(entry: Fact, claimed: string): AssertedCheck {
  return {
    kind: "fact",
    claim: { label: entry.topic, topic: entry.topic, claimed },
    verdict: claimed === entry.value ? "match" : "mismatch",
    evidence: SHOP.prove(entry),
  };
}

const mriCovered = claim(MRI, "covered");
const copayRight = claim(COPAY, "20");
const copayWrong = claim(COPAY, "10");
const cosmeticTrue = claim(COSMETIC, "excluded");

function stars(needs: readonly Need[], ...checks: readonly AssertedCheck[]): number {
  return grade(verifyChecks(checks, PINNED, QUESTION, needs)).stars;
}

test("an honest answer that opens every needed key in its favour rates 5", () => {
  assert.equal(stars([NEED_MRI, NEED_COPAY], mriCovered, copayRight), 5);
  assert.equal(stars([NEED_MRI], mriCovered), 5);
});

test("the three omission exploits rate low: cherry-picking, a true check about another key, and no checks", () => {
  assert.equal(stars([NEED_MRI, NEED_COPAY], mriCovered), 3);
  assert.equal(stars([NEED_MRI], cosmeticTrue), 2);
  assert.equal(stars([NEED_MRI, NEED_COPAY], cosmeticTrue), 1);
  assert.equal(stars([NEED_MRI]), 2);
});

test("withholding a key always rates below proving it, even when the proof is a mismatch", () => {
  const honest = stars([NEED_MRI, NEED_COPAY], mriCovered, copayWrong);
  const hidden = stars([NEED_MRI, NEED_COPAY], mriCovered);
  assert.equal(honest, 4);
  assert.ok(hidden < honest);
});

test("a true check the buyer did not ask for never raises the rating, and a false one never lowers it", () => {
  assert.equal(stars([NEED_MRI, NEED_COPAY], mriCovered, copayWrong, cosmeticTrue), 4);
  assert.equal(stars([NEED_MRI], cosmeticTrue, cosmeticTrue), 2);
  assert.equal(stars([NEED_MRI], mriCovered, claim(COSMETIC, "covered")), 5);
});

test("a needed key opened with no claim, or proved empty, backs nothing", () => {
  const opened: AssertedCheck = { kind: "opening", key: factKey(MRI), verdict: "opened", evidence: SHOP.prove(MRI) };
  assert.equal(stars([NEED_MRI], opened), 2);
  assert.equal(stars([NEED_MRI, NEED_COPAY], mriCovered, { kind: "opening", key: factKey(COPAY), verdict: "opened", evidence: SHOP.prove(COPAY) }), 5);
  const empty: AssertedCheck = { kind: "opening", key: factKey(NEED_DENTAL), verdict: "unverifiable", evidence: SHOP.proveAbsent(factKey(NEED_DENTAL)) };
  assert.equal(stars([NEED_MRI, NEED_DENTAL], mriCovered, empty), 4);
});

test("one forged check sets the rating to 1 whatever else was verified, and the tally counts each status", () => {
  const forged: AssertedCheck = {
    kind: "fact",
    claim: { label: "copay", topic: "mri-copay", claimed: "10" },
    verdict: "match",
    evidence: { ...SHOP.prove(COPAY), entry: { ...COPAY, value: "10" } },
  };
  const graded = grade(verifyChecks([mriCovered, forged, cosmeticTrue], PINNED, QUESTION, [NEED_MRI, NEED_COPAY]));
  assert.equal(graded.stars, 1);
  assert.deepEqual(graded.tally, { verified: 1, backing: 1, mismatches: 0, empty: 0, withheld: 1, unrequested: 1, unproven: 0, forged: 1 });
});
