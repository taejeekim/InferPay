import assert from "node:assert/strict";
import test from "node:test";
import { factKey, sealDataset, type AssertedCheck, type Fact, type Need, type PinnedCommitment } from "../commitment/index.ts";
import { parseHash } from "../commitment/merkle.ts";
import { grade } from "./grade.ts";
import { verifyChecks } from "./verify.ts";

const MRI: Fact = { kind: "fact", topic: "outpatient-mri", value: "covered", source: "schedule 4.2" };
const COPAY: Fact = { kind: "fact", topic: "mri-copay", value: "20", source: "schedule 4.2" };
const COSMETIC: Fact = { kind: "fact", topic: "cosmetic-surgery", value: "excluded", source: "schedule 9.1" };
const DEDUCTIBLE: Fact = { kind: "fact", topic: "deductible", value: "500", source: "schedule 1.1" };
const SHOP = sealDataset([MRI, COPAY, COSMETIC, DEDUCTIBLE].map((entry, index) => {
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

test("the three omission exploits rate below an honest mismatch: cherry-picking, a true check about another key, and no checks", () => {
  assert.equal(stars([NEED_MRI, NEED_COPAY], mriCovered), 3);
  assert.equal(stars([NEED_MRI], cosmeticTrue), 3);
  assert.equal(stars([NEED_MRI, NEED_COPAY], cosmeticTrue), 2);
  assert.equal(stars([NEED_MRI]), 3);
});

test("for one to four needed keys: all matched > one honest mismatch > one key withheld > anything forged", () => {
  const facts = [COPAY, MRI, DEDUCTIBLE, COSMETIC];
  for (let count = 1; count <= facts.length; count += 1) {
    const needed = facts.slice(0, count);
    const needs = needed.map((fact): Need => ({ kind: "fact", topic: fact.topic }));
    const matched = needed.map((fact) => claim(fact, fact.value));
    const rest = matched.slice(1);
    const allMatched = stars(needs, ...matched);
    const oneMismatch = stars(needs, copayWrong, ...rest);
    const oneWithheld = stars(needs, ...rest);
    const lie = (verdict: "match" | "mismatch", evidence: AssertedCheck["evidence"]): AssertedCheck => ({
      kind: "fact",
      claim: { label: COPAY.topic, topic: COPAY.topic, claimed: "10" },
      verdict,
      evidence,
    });
    const forgeries = [
      lie("match", SHOP.prove(COPAY)),
      lie("match", { ...SHOP.prove(COPAY), entry: { ...COPAY, value: "10" } }),
      lie("mismatch", SHOP.prove(MRI)),
    ].map((forged) => stars(needs, forged, ...rest));
    assert.ok(allMatched > oneMismatch, `${count} needed: ${allMatched} > ${oneMismatch}`);
    assert.ok(oneMismatch > oneWithheld, `${count} needed: ${oneMismatch} > ${oneWithheld}`);
    for (const forged of forgeries) assert.ok(oneWithheld > forged, `${count} needed: ${oneWithheld} > ${forged}`);
    assert.ok(stars(needs) > Math.max(...forgeries), `${count} needed: sending nothing still rates above a forgery`);
  }
});

test("a true check the buyer did not ask for never raises the rating, and a false one never lowers it", () => {
  assert.equal(stars([NEED_MRI, NEED_COPAY], mriCovered, copayWrong, cosmeticTrue), 4);
  assert.equal(stars([NEED_MRI], cosmeticTrue, cosmeticTrue), 3);
  assert.equal(stars([NEED_MRI], mriCovered, claim(COSMETIC, "covered")), 5);
});

test("a needed key opened with no claim, or proved empty, costs what a mismatch costs", () => {
  const opened: AssertedCheck = { kind: "opening", key: factKey(MRI), verdict: "opened", evidence: SHOP.prove(MRI) };
  assert.equal(stars([NEED_MRI], opened), 4);
  const bareCopay: AssertedCheck = { kind: "opening", key: factKey(COPAY), verdict: "opened", evidence: SHOP.prove(COPAY) };
  assert.equal(stars([NEED_MRI, NEED_COPAY], mriCovered, bareCopay), 4);
  assert.equal(stars([NEED_MRI, NEED_COPAY], mriCovered, bareCopay), stars([NEED_MRI, NEED_COPAY], mriCovered, copayWrong));
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
  assert.deepEqual(graded.tally, { verified: 1, mismatches: 0, empty: 0, unclaimed: 0, withheld: 1, unrequested: 1, unproven: 0, forged: 1 });
});
