import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPTH,
  entryKey,
  factKey,
  figureKey,
  judgeFact,
  judgeFigure,
  opensTo,
  parseAssertedChecks,
  quotedFrom,
  ruleHits,
  sameKey,
  sealDataset,
  SCHEME,
  TOLERANCE_PCT,
  type Fact,
  type Figure,
  type Rule,
} from "./index.ts";
import { parseHash, type Hash } from "./merkle.ts";

function salt(byte: string): Hash {
  const parsed = parseHash(byte.repeat(32));
  if (!parsed) throw new Error("fixture salt");
  return parsed;
}

const REVENUE: Figure = {
  kind: "figure",
  company: "Samsung Electronics",
  period: "Q3 2025",
  metric: "revenue",
  value: 86.1,
  unit: "KRW T",
  source: "Samsung Electronics Q3 2025 earnings release",
};

const FACTS: readonly Fact[] = ["mri", "copay", "cosmetic"].map((topic) => ({ kind: "fact", topic, value: "covered", source: "schedule" }));

function sealed() {
  return sealDataset(FACTS.map((entry, index) => ({ entry, salt: salt(`0${index + 1}`) })));
}

function revenueClaim(claimed: number, unit = "KRW T") {
  return { label: "revenue", company: "samsung  electronics", period: "q3 2025", metric: "Revenue", claimed, unit };
}

test("a sealed dataset publishes only a root, a leaf count, and the scheme, and proves each entry at its key's slot", () => {
  const data = sealed();
  assert.deepEqual(Object.keys(data.commitment).sort(), ["leaves", "root", "scheme"]);
  assert.equal(data.commitment.scheme, SCHEME);
  assert.equal(data.commitment.leaves, 3);
  for (const entry of data.entries) assert.equal(opensTo(entryKey(entry), data.prove(entry)), data.commitment.root);
});

test("the same entries and salts seal to the same root, and a different salt to a different one", () => {
  const rows = FACTS.map((entry, index) => ({ entry, salt: salt(`0${index + 1}`) }));
  assert.equal(sealDataset(rows).commitment.root, sealDataset([...rows].reverse()).commitment.root);
  const resalted = rows.map((row, index) => (index === 2 ? { ...row, salt: salt("ff") } : row));
  assert.notEqual(sealDataset(resalted).commitment.root, sealDataset(rows).commitment.root);
});

test("a dataset cannot hold two entries for one key, so a root never commits to two answers", () => {
  const covered: Fact = { kind: "fact", topic: "mri", value: "covered", source: "schedule" };
  const excluded: Fact = { kind: "fact", topic: "MRI", value: "excluded", source: "schedule" };
  assert.throws(() => sealDataset([{ entry: covered, salt: salt("01") }, { entry: excluded, salt: salt("02") }]), /two entries share the key/);
});

test("evidence opens to the root only for its own key, and not once the entry is rewritten", () => {
  const data = sealed();
  const first = data.entries[0];
  assert.ok(first);
  const evidence = data.prove(first);
  assert.notEqual(opensTo(entryKey(first), { ...evidence, entry: { ...first, value: "excluded" } }), data.commitment.root);
  assert.notEqual(opensTo(factKey({ topic: "copay" }), evidence), data.commitment.root);
});

test("a key the dataset has no entry for is proven absent, and a key it holds cannot be", () => {
  const data = sealed();
  const absent = data.proveAbsent(factKey({ topic: "dental" }));
  assert.ok(absent);
  assert.equal(opensTo(factKey({ topic: "dental" }), absent), data.commitment.root);
  assert.equal(data.proveAbsent(factKey({ topic: "MRI" })), null);
  assert.notEqual(opensTo(factKey({ topic: "mri" }), absent), data.commitment.root);
});

test("a figure within 0.05 percent matches, and 86.0 against 86.1 is a 0.12 percent mismatch", () => {
  assert.ok(sameKey(figureKey(revenueClaim(86.1)), figureKey(REVENUE)));
  assert.equal(sameKey(figureKey({ ...revenueClaim(86.1), metric: "operating profit" }), figureKey(REVENUE)), false);
  assert.deepEqual(judgeFigure(revenueClaim(86.1), REVENUE), { verdict: "match" });
  assert.deepEqual(judgeFigure(revenueClaim(86100, "KRW B"), REVENUE), { verdict: "match" });
  const off = judgeFigure(revenueClaim(86), REVENUE);
  assert.equal(off.verdict, "mismatch");
  if (off.verdict !== "mismatch") return;
  assert.ok(Math.abs(off.deltaPct) > TOLERANCE_PCT);
  assert.equal(off.deltaPct.toFixed(2), "-0.12");
});

test("a figure claimed in another currency cannot be compared", () => {
  assert.deepEqual(judgeFigure(revenueClaim(86.1, "USD T"), REVENUE), { verdict: "unverifiable" });
});

test("a stated fact ignores case, spacing, and a trailing percent sign", () => {
  const copay: Fact = { kind: "fact", topic: "mri-copay", value: "20", source: "schedule" };
  assert.ok(sameKey(factKey({ topic: "MRI-Copay" }), factKey(copay)));
  assert.equal(judgeFact({ label: "copay", topic: "mri-copay", claimed: " 20 percent" }, copay), "match");
  assert.equal(judgeFact({ label: "copay", topic: "mri-copay", claimed: "30" }, copay), "mismatch");
});

test("a rule hits a clause that matches every pattern, and never when it would hit an empty clause or cannot compile", () => {
  const rule: Rule = { kind: "rule", id: "uncapped", all: ["unlimited|without limit", "indemn"], label: "uncapped indemnity", detail: "cap it" };
  assert.ok(ruleHits(rule, "The party shall INDEMNIFY the discloser without limit."));
  assert.equal(ruleHits(rule, "Unlimited liability for breach."), false);
  assert.equal(ruleHits({ ...rule, all: ["^"] }, "Unlimited indemnification."), false);
  assert.equal(ruleHits({ ...rule, all: ["("] }, "anything"), false);
  assert.equal(ruleHits({ ...rule, all: [] }, "anything"), false);
});

test("a clause counts as the buyer's only when the question contains it", () => {
  const question = "Does this NDA's unlimited indemnification clause fail our playbook?";
  assert.ok(quotedFrom(question, "unlimited indemnification clause"));
  assert.ok(quotedFrom(question, ' "Unlimited   indemnification clause." '));
  assert.equal(quotedFrom(question, "The receiving party shall provide unlimited indemnification."), false);
  assert.equal(quotedFrom(question, " "), false);
});

test("a check with a malformed salt or a path that is not 32 levels is not a check", () => {
  const data = sealDataset([{ entry: REVENUE, salt: salt("0a") }]);
  const evidence = data.prove(REVENUE);
  const check = { kind: "number", claim: revenueClaim(86.1), verdict: "match", evidence };
  assert.equal(evidence.path.length, DEPTH);
  assert.equal(parseAssertedChecks([check])?.length, 1);
  assert.equal(parseAssertedChecks([{ ...check, evidence: { ...evidence, salt: "xyz" } }]), null);
  assert.equal(parseAssertedChecks([{ ...check, evidence: { ...evidence, path: [...evidence.path, null] } }]), null);
  assert.equal(parseAssertedChecks([{ ...check, evidence: { ...evidence, path: evidence.path.slice(1) } }]), null);
  assert.equal(parseAssertedChecks([{ ...check, verdict: "raised" }]), null);
  assert.equal(parseAssertedChecks([{ ...check, verdict: "unverifiable", evidence: { vacant: true, path: evidence.path } }])?.length, 1);
});
