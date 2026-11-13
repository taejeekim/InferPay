import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountId } from "../domain.ts";
import {
  factKey,
  figureKey,
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
const QUESTION = "Does this NDA's unlimited indemnification clause fail our playbook?";

function salt(seed: number): Hash {
  const parsed = parseHash(seed.toString(16).padStart(2, "0").repeat(32));
  if (!parsed) throw new Error("fixture salt");
  return parsed;
}

function claimOf(metric: string, claimed: number) {
  return { label: metric, company: "Samsung Electronics", period: "Q3 2025", metric, claimed, unit: "KRW T" };
}

function revenue(claimed: number, verdict: "match" | "mismatch"): AssertedCheck {
  return { kind: "number", claim: claimOf("revenue", claimed), verdict, evidence: SHOP.prove(REVENUE) };
}

function flag(text: string, verdict: "raised" | "clear" = "raised"): AssertedCheck {
  return { kind: "flag", claim: { label: "indemnity", text }, verdict, evidence: verdict === "raised" ? SHOP.prove(INDEMNITY) : null };
}

function only(check: AssertedCheck, pinned: PinnedCommitment = PINNED): BuyerCheck {
  const [result] = verifyChecks([check], pinned, QUESTION);
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

  const raised = only(flag("unlimited indemnification clause"));
  assert.ok(raised.status === "verified" && raised.kind === "flag");
  assert.equal(raised.entry.label, "uncapped indemnity");
});

test("a shop that calls a 0.12 percent miss a match is caught by the buyer's own arithmetic", () => {
  const caught = only(revenue(86, "match"));
  assert.ok(caught.status === "forged");
  assert.deepEqual(caught.forgery, { kind: "wrong-verdict", recomputed: "mismatch" });
  const reverse = only(revenue(86.1, "mismatch"));
  assert.ok(reverse.status === "forged" && reverse.forgery.kind === "wrong-verdict");
});

test("an entry rewritten to agree with the claim no longer opens to the committed root", () => {
  const forged = only({ kind: "number", claim: claimOf("revenue", 86), verdict: "match", evidence: { ...SHOP.prove(REVENUE), entry: { ...REVENUE, value: 86 } } });
  assert.ok(forged.status === "forged" && forged.forgery.kind === "wrong-root");
  assert.equal(forged.forgery.committed, SHOP.commitment.root);
  assert.notEqual(forged.forgery.opensTo, SHOP.commitment.root);
});

test("a changed salt, a changed path, and a different committed root each fail the walk", () => {
  const evidence = SHOP.prove(REVENUE);
  const claim = claimOf("revenue", 86.1);
  const level = evidence.path.findIndex((sibling) => sibling !== null);
  assert.ok(level >= 0);
  const tampered: AssertedCheck[] = [
    { kind: "number", claim, verdict: "match", evidence: { ...evidence, salt: salt(99) } },
    { kind: "number", claim, verdict: "match", evidence: { ...evidence, path: evidence.path.map((sibling, index) => (index === level ? null : sibling)) } },
    { kind: "number", claim, verdict: "match", evidence: { ...evidence, path: SHOP.prove(PROFIT).path } },
    { kind: "number", claim, verdict: "match", evidence: { ...evidence, path: evidence.path.slice(1) } },
  ];
  for (const check of tampered) {
    const result = only(check);
    assert.ok(result.status === "forged" && result.forgery.kind === "wrong-root");
  }
  const other = parseCommitment({ scheme: SCHEME, root: "ab".repeat(32), leaves: 4 });
  assert.ok(other);
  const elsewhere = only(revenue(86.1, "match"), { ...PINNED, commitment: other });
  assert.ok(elsewhere.status === "forged" && elsewhere.forgery.kind === "wrong-root");
});

test("a real entry about something else, or of the wrong kind, does not back the claim", () => {
  const borrowed = only({ kind: "number", claim: claimOf("revenue", 12.2), verdict: "match", evidence: SHOP.prove(PROFIT) });
  assert.ok(borrowed.status === "forged" && borrowed.forgery.kind === "wrong-entry");
  const wrongKind = only({ kind: "number", claim: claimOf("revenue", 86.1), verdict: "match", evidence: SHOP.prove(MRI) });
  assert.ok(wrongKind.status === "forged" && wrongKind.forgery.kind === "wrong-entry");
  const moved = only({ kind: "number", claim: claimOf("revenue", 12.2), verdict: "match", evidence: { ...SHOP.prove(PROFIT), entry: { ...PROFIT, metric: "revenue" } } });
  assert.ok(moved.status === "forged" && moved.forgery.kind === "wrong-root");
});

test("a positive verdict with no entry behind it is forged", () => {
  const bare = only({ kind: "number", claim: claimOf("revenue", 86.1), verdict: "match", evidence: null });
  assert.ok(bare.status === "forged" && bare.forgery.kind === "no-evidence");
  const vacancy = SHOP.proveAbsent(figureKey(claimOf("capex", 1)));
  assert.ok(vacancy);
  const empty = only({ kind: "number", claim: claimOf("capex", 1), verdict: "match", evidence: vacancy });
  assert.ok(empty.status === "forged" && empty.forgery.kind === "no-evidence");
});

test("the buyer verifies that the shop holds no entry for a key, and catches a shop that hides one it holds", () => {
  const capex = claimOf("capex", 1);
  const vacancy = SHOP.proveAbsent(figureKey(capex));
  assert.ok(vacancy);
  const absent = only({ kind: "number", claim: capex, verdict: "unverifiable", evidence: vacancy });
  assert.ok(absent.status === "verified" && absent.verdict === "absent");

  const hidden = only({ kind: "number", claim: claimOf("revenue", 86), verdict: "unverifiable", evidence: vacancy });
  assert.ok(hidden.status === "forged" && hidden.forgery.kind === "wrong-root");
  assert.equal(SHOP.proveAbsent(figureKey(claimOf("revenue", 86))), null);

  const dental = { label: "dental", topic: "dental", claimed: "covered" };
  const noFact = SHOP.proveAbsent(factKey(dental));
  assert.ok(noFact);
  const absentFact = only({ kind: "fact", claim: dental, verdict: "unverifiable", evidence: noFact });
  assert.ok(absentFact.status === "verified" && absentFact.verdict === "absent");
});

test("an unverifiable claim with no proof and a clear flag are the shop's word only", () => {
  const unbacked = only({ kind: "number", claim: claimOf("capex", 1), verdict: "unverifiable", evidence: null });
  assert.deepEqual([unbacked.status, unbacked.status === "unproven" && unbacked.why], ["unproven", "no-proof"]);
  const withEntry = only({ kind: "number", claim: claimOf("revenue", 86), verdict: "unverifiable", evidence: SHOP.prove(REVENUE) });
  assert.equal(withEntry.status, "unproven");
  assert.equal(only(flag("Twelve months.", "clear")).status, "unproven");
});

test("a raised flag counts only for a clause quoted from the buyer's question, and only when the rule really hits it", () => {
  const invented = only(flag("The receiving party shall provide unlimited indemnification."));
  assert.deepEqual([invented.status, invented.status === "unproven" && invented.why], ["unproven", "unquoted"]);
  const quiet = only(flag("fail our playbook"));
  assert.ok(quiet.status === "forged");
  assert.deepEqual(quiet.forgery, { kind: "wrong-verdict", recomputed: "clear" });
});

test("with no published root every positive verdict is the shop's word only", () => {
  const contract = parseAccountId("v1.social08.testnet");
  const account = parseAccountId("disclosure.david.inferpay.testnet");
  assert.ok(contract && account);
  const result = only(revenue(86.1, "match"), { status: "missing", contract, account });
  assert.deepEqual([result.status, result.status === "unproven" && result.why], ["unproven", "no-commitment"]);
});
