import assert from "node:assert/strict";
import test from "node:test";
import {
  judgeFact,
  judgeFigure,
  opensTo,
  parseAssertedChecks,
  ruleHits,
  sameFigure,
  sameTopic,
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

function revenueClaim(claimed: number, unit = "KRW T") {
  return { label: "revenue", company: "samsung  electronics", period: "q3 2025", metric: "Revenue", claimed, unit };
}

test("a sealed dataset publishes only a root, a leaf count, and the scheme, and proves each entry against it", () => {
  const data = sealDataset(FACTS.map((entry, index) => ({ entry, salt: salt(`0${index + 1}`) })));
  assert.deepEqual(Object.keys(data.commitment).sort(), ["leaves", "root", "scheme"]);
  assert.equal(data.commitment.scheme, SCHEME);
  assert.equal(data.commitment.leaves, 3);
  for (const entry of data.entries) assert.equal(opensTo(data.prove(entry)), data.commitment.root);
});

test("the same entries and salts seal to the same root, and a different salt to a different one", () => {
  const rows = FACTS.map((entry, index) => ({ entry, salt: salt(`0${index + 1}`) }));
  assert.equal(sealDataset(rows).commitment.root, sealDataset(rows.map((row) => ({ ...row }))).commitment.root);
  const resalted = rows.map((row, index) => (index === 2 ? { ...row, salt: salt("ff") } : row));
  assert.notEqual(sealDataset(resalted).commitment.root, sealDataset(rows).commitment.root);
});

test("evidence with a rewritten entry no longer opens to the root", () => {
  const data = sealDataset(FACTS.map((entry, index) => ({ entry, salt: salt(`0${index + 1}`) })));
  const first = data.entries[0];
  assert.ok(first);
  const evidence = data.prove(first);
  assert.notEqual(opensTo({ ...evidence, entry: { ...first, value: "excluded" } }), data.commitment.root);
});

test("a figure within 0.05 percent matches, and 86.0 against 86.1 is a 0.12 percent mismatch", () => {
  assert.ok(sameFigure(revenueClaim(86.1), REVENUE));
  assert.equal(sameFigure({ ...revenueClaim(86.1), metric: "operating profit" }, REVENUE), false);
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
  assert.ok(sameTopic({ label: "copay", topic: "MRI-Copay", claimed: "20%" }, copay));
  assert.equal(judgeFact({ label: "copay", topic: "mri-copay", claimed: " 20 percent" }, copay), "match");
  assert.equal(judgeFact({ label: "copay", topic: "mri-copay", claimed: "30" }, copay), "mismatch");
});

test("a rule hits a clause that matches every pattern, and a rule that cannot compile hits nothing", () => {
  const rule: Rule = { kind: "rule", id: "uncapped", all: ["unlimited|without limit", "indemn"], label: "uncapped indemnity", detail: "cap it" };
  assert.ok(ruleHits(rule, "The party shall INDEMNIFY the discloser without limit."));
  assert.equal(ruleHits(rule, "Unlimited liability for breach."), false);
  assert.equal(ruleHits({ ...rule, all: ["("] }, "anything"), false);
  assert.equal(ruleHits({ ...rule, all: [] }, "anything"), false);
});

test("a check with a malformed salt or an overlong path is not a check", () => {
  const data = sealDataset([{ entry: REVENUE, salt: salt("0a") }]);
  const check = { kind: "number", claim: revenueClaim(86.1), verdict: "match", evidence: data.prove(REVENUE) };
  assert.equal(parseAssertedChecks([check])?.length, 1);
  assert.equal(parseAssertedChecks([{ ...check, evidence: { ...check.evidence, salt: "xyz" } }]), null);
  const step = { side: "left", hash: salt("0b") };
  assert.equal(parseAssertedChecks([{ ...check, evidence: { ...check.evidence, path: Array.from({ length: 65 }, () => step) } }]), null);
  assert.equal(parseAssertedChecks([{ ...check, verdict: "raised" }]), null);
});
