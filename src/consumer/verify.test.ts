import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountId } from "../domain.ts";
import {
  parseCommitment,
  sealDataset,
  SCHEME,
  type AssertedCheck,
  type Entry,
  type Fact,
  type Figure,
  type PinnedCommitment,
  type Rule,
} from "../commitment/index.ts";
import { parseHash, type Hash } from "../commitment/merkle.ts";
import { verifyChecks, type BuyerCheck } from "./verify.ts";

const REVENUE: Figure = { kind: "figure", company: "Samsung Electronics", period: "Q3 2025", metric: "revenue", value: 86.1, unit: "KRW T", source: "earnings release" };
const PROFIT: Figure = { ...REVENUE, metric: "operating profit", value: 12.2 };
const MRI: Fact = { kind: "fact", topic: "outpatient-mri", value: "covered", source: "schedule 4.2" };
const INDEMNITY: Rule = { kind: "rule", id: "uncapped", all: ["unlimited", "indemn"], label: "uncapped indemnity", detail: "cap it" };

const SHOP = sealDataset<Entry>([REVENUE, PROFIT, MRI, INDEMNITY].map((entry, index) => ({ entry, salt: salt(index + 1) })));
const PINNED: PinnedCommitment = { status: "published", commitment: SHOP.commitment, source: { kind: "listing" } };

function salt(seed: number): Hash {
  const parsed = parseHash(seed.toString(16).padStart(2, "0").repeat(32));
  if (!parsed) throw new Error("fixture salt");
  return parsed;
}

function revenue(claimed: number, verdict: "match" | "mismatch" | "unverifiable"): AssertedCheck {
  const claim = { label: "revenue", company: "Samsung Electronics", period: "Q3 2025", metric: "revenue", claimed, unit: "KRW T" };
  return { kind: "number", claim, verdict, evidence: SHOP.prove(REVENUE) };
}

function only(check: AssertedCheck, pinned: PinnedCommitment = PINNED): BuyerCheck {
  const [result] = verifyChecks([check], pinned);
  assert.ok(result);
  return result;
}

test("the buyer recomputes match, mismatch, and raised from entries that open to the committed root", () => {
  const match = only(revenue(86.1, "match"));
  assert.equal(match.status, "verified");
  const mismatch = only(revenue(86, "mismatch"));
  assert.ok(mismatch.status === "verified" && mismatch.kind === "number" && mismatch.verdict === "mismatch");
  assert.equal(mismatch.deltaPct.toFixed(2), "-0.12");
  assert.equal(mismatch.entry.value, 86.1);

  const fact = only({ kind: "fact", claim: { label: "MRI", topic: "outpatient-mri", claimed: "covered" }, verdict: "match", evidence: SHOP.prove(MRI) });
  assert.ok(fact.status === "verified" && fact.verdict === "match");

  const flag = only({ kind: "flag", claim: { label: "indemnity", text: "Unlimited indemnification applies." }, verdict: "raised", evidence: SHOP.prove(INDEMNITY) });
  assert.ok(flag.status === "verified" && flag.kind === "flag");
  assert.equal(flag.entry.label, "uncapped indemnity");
});

test("a shop that calls a 0.12 percent miss a match is caught by the buyer's own arithmetic", () => {
  const caught = only(revenue(86, "match"));
  assert.ok(caught.status === "forged");
  assert.deepEqual(caught.forgery, { kind: "wrong-verdict", recomputed: "mismatch" });
  const reverse = only(revenue(86.1, "mismatch"));
  assert.ok(reverse.status === "forged" && reverse.forgery.kind === "wrong-verdict");
});

test("an entry rewritten to agree with the claim no longer opens to the committed root", () => {
  const honest = revenue(86, "match");
  assert.ok(honest.evidence);
  const forged = only({ ...honest, evidence: { ...honest.evidence, entry: { ...REVENUE, value: 86 } } } as AssertedCheck);
  assert.ok(forged.status === "forged");
  assert.equal(forged.forgery.kind, "wrong-root");
  if (forged.forgery.kind !== "wrong-root") return;
  assert.equal(forged.forgery.committed, SHOP.commitment.root);
  assert.notEqual(forged.forgery.opensTo, SHOP.commitment.root);
});

test("a changed salt, a changed path, and a different committed root each fail the walk", () => {
  const honest = revenue(86.1, "match");
  assert.ok(honest.evidence);
  const { evidence } = honest;
  const resalted = only({ ...honest, evidence: { ...evidence, salt: salt(99) } } as AssertedCheck);
  const shortened = only({ ...honest, evidence: { ...evidence, path: evidence.path.slice(1) } } as AssertedCheck);
  const flipped = only({
    ...honest,
    evidence: { ...evidence, path: evidence.path.map((step) => ({ ...step, side: step.side === "left" ? "right" : "left" })) },
  } as AssertedCheck);
  for (const result of [resalted, shortened, flipped]) {
    assert.ok(result.status === "forged" && result.forgery.kind === "wrong-root");
  }
  const other = parseCommitment({ scheme: SCHEME, root: "ab".repeat(32), leaves: 4 });
  assert.ok(other);
  const elsewhere = only(honest, { ...PINNED, commitment: other });
  assert.ok(elsewhere.status === "forged" && elsewhere.forgery.kind === "wrong-root");
});

test("a real entry about something else, or of the wrong kind, does not back the claim", () => {
  const borrowed = only({ ...revenue(12.2, "match"), evidence: SHOP.prove(PROFIT) } as AssertedCheck);
  assert.ok(borrowed.status === "forged" && borrowed.forgery.kind === "wrong-entry");
  const wrongKind = only({ ...revenue(86.1, "match"), evidence: SHOP.prove(MRI) } as AssertedCheck);
  assert.ok(wrongKind.status === "forged" && wrongKind.forgery.kind === "wrong-entry");
  const quiet = only({ kind: "flag", claim: { label: "term", text: "Twelve months." }, verdict: "raised", evidence: SHOP.prove(INDEMNITY) });
  assert.ok(quiet.status === "forged");
  assert.deepEqual(quiet.forgery, { kind: "wrong-verdict", recomputed: "clear" });
});

test("a positive verdict with no evidence is forged, and an absence is unproven whatever comes with it", () => {
  const bare = only({ ...revenue(86.1, "match"), evidence: null } as AssertedCheck);
  assert.ok(bare.status === "forged" && bare.forgery.kind === "no-evidence");
  const absent = only({ ...revenue(1, "unverifiable"), evidence: null } as AssertedCheck);
  assert.deepEqual([absent.status, absent.status === "unproven" && absent.why], ["unproven", "absence"]);
  const clear = only({ kind: "flag", claim: { label: "term", text: "Twelve months." }, verdict: "clear", evidence: null });
  assert.equal(clear.status, "unproven");
});

test("with no published root every positive verdict is the shop's word only", () => {
  const contract = parseAccountId("v1.social08.testnet");
  const account = parseAccountId("disclosure.david.inferpay.testnet");
  assert.ok(contract && account);
  const result = only(revenue(86.1, "match"), { status: "missing", contract, account });
  assert.deepEqual([result.status, result.status === "unproven" && result.why], ["unproven", "no-commitment"]);
});
