import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonical,
  entryKey,
  factKey,
  leafHash,
  opensTo,
  parseHash,
  slotOf,
  type AssertedCheck,
  type Entry,
  type Evidence,
  type Hash,
  type Key,
  type Need,
} from "../commitment/index.ts";
import type { Json } from "../commitment/merkle.ts";
import { progressLine } from "../cli/render.ts";
import { grade, RULE } from "../consumer/grade.ts";
import { verifyChecks, type BuyerCheck } from "../consumer/verify.ts";
import { newJobId } from "../domain.ts";
import { evidenceModule, EVIDENCE_MODULE, sampleDatasets, siteEvidence } from "./evidence.ts";

type SiteResult = { readonly status: string; readonly verdict?: string; readonly forgery?: string; readonly need?: { readonly topic: string } };

type SiteScheme = {
  canonical(value: unknown): string;
  entryKey(entry: Entry): Key;
  slotOf(key: Key): Promise<number>;
  leafHash(entry: Entry, salt: string): Promise<string | null>;
  opensTo(key: Key, evidence: unknown): Promise<string | null>;
  verifyFact(check: unknown, committed: string): Promise<SiteResult>;
  verifyChecks(checks: readonly unknown[], committed: string, needs: readonly Need[]): Promise<readonly SiteResult[]>;
};
type SiteGrade = {
  readonly RULE: unknown;
  grade(results: readonly unknown[]): unknown;
  rateLines(graded: unknown): readonly string[];
};

const site = (await import(new URL("../../docs/js/scheme.js", import.meta.url).href)) as SiteScheme;
const siteGrade = (await import(new URL("../../docs/js/grade.js", import.meta.url).href)) as SiteGrade;

// The roots the three shops published on NEAR testnet under inferpay.testnet.
const ON_CHAIN = {
  insurance: "d26d1609271e8c546648dc3d83990ff7540d60bf40cdf738d693ec655602b68f",
  disclosure: "4bc59b533ac3b45997fa8cb2af6bac1052a8fa9c88247405fbc8c1087cd2a40a",
  legal: "4a19e743ea7432156c47bfb0a33558b1e1988e1710d6e7e9e05761299c35d9b5",
};

test("the sample datasets seal to the roots the shops published on testnet", () => {
  const datasets = sampleDatasets();
  for (const [shop, root] of Object.entries(ON_CHAIN)) {
    assert.equal(datasets[shop as keyof typeof datasets].commitment.root, root, shop);
  }
});

test("the browser scheme gives the same canonical bytes, slots, leaf hashes, and roots as src/commitment", async () => {
  for (const [shop, dataset] of Object.entries(sampleDatasets())) {
    for (const entry of dataset.entries as readonly Entry[]) {
      const key = entryKey(entry);
      const evidence = (dataset.prove as (entry: Entry) => Evidence)(entry);
      assert.ok(!("vacant" in evidence));
      assert.equal(site.canonical(entry), canonical(entry as Json), shop);
      assert.deepEqual(site.entryKey(entry), key, shop);
      assert.equal(await site.slotOf(key), slotOf(key), shop);
      assert.equal(await site.leafHash(entry, evidence.salt), leafHash(entry as Json, evidence.salt), shop);
      assert.equal(await site.opensTo(key, evidence), dataset.commitment.root, shop);
    }
  }
});

test("the browser scheme opens an empty slot to the same root as src/commitment", async () => {
  const { insurance } = sampleDatasets();
  for (const topic of ["dental-implants", "chiropractic", "Outpatient-CT"]) {
    const key = factKey({ topic });
    const vacancy = insurance.proveAbsent(key);
    assert.ok(vacancy, topic);
    assert.equal(opensTo(key, vacancy), insurance.commitment.root, topic);
    assert.equal(await site.opensTo(key, vacancy), insurance.commitment.root, topic);
  }
});

function hash(raw: string): Hash {
  const parsed = parseHash(raw);
  if (!parsed) throw new Error(`fixture is not a hash: ${raw}`);
  return parsed;
}

function flip(hex: string, at: number): Hash {
  const next = hex[at] === "0" ? "1" : "0";
  return hash(`${hex.slice(0, at)}${next}${hex.slice(at + 1)}`);
}

type FactCheck = Extract<AssertedCheck, { kind: "fact" }>;

// Each case is the list of checks a shop sends for the embedded question: the outpatient MRI check, the copay
// check, and the dental check the buyer did not ask for, with one of them tampered with or left out.
function cases(): readonly { readonly name: string; readonly checks: readonly FactCheck[] }[] {
  const { present, copay, absent } = siteEvidence();
  const base: FactCheck = { kind: "fact", claim: present.claim, verdict: "match", evidence: present.evidence };
  const second: FactCheck = { kind: "fact", claim: copay.claim, verdict: "match", evidence: copay.evidence };
  const evidence = present.evidence;
  const path = evidence.path;
  const firstSibling = path.findIndex((sibling) => sibling !== null);
  const vacant: FactCheck = { kind: "fact", claim: absent.claim, verdict: "unverifiable", evidence: absent.evidence };
  const sent = (check: FactCheck): readonly FactCheck[] => [check, second, vacant];
  const sentAbsent = (check: FactCheck): readonly FactCheck[] => [base, second, check];
  return [
    { name: "honest", checks: sent(base) },
    { name: "value changed to excluded", checks: sent({ ...base, evidence: { ...evidence, entry: { ...evidence.entry, value: "excluded" } } }) },
    { name: "source changed", checks: sent({ ...base, evidence: { ...evidence, entry: { ...evidence.entry, source: "made up" } } }) },
    { name: "topic changed", checks: sent({ ...base, evidence: { ...evidence, entry: { ...evidence.entry, topic: "mri-copay" } } }) },
    { name: "case of the topic changed", checks: sent({ ...base, evidence: { ...evidence, entry: { ...evidence.entry, topic: "Outpatient-MRI" } } }) },
    ...[0, 17, 63].map((at) => ({ name: `salt flipped at ${at}`, checks: sent({ ...base, evidence: { ...evidence, salt: flip(evidence.salt, at) } }) })),
    { name: "a non-empty sibling dropped", checks: sent({ ...base, evidence: { ...evidence, path: path.map((sibling, level) => (level === firstSibling ? null : sibling)) } }) },
    { name: "an empty sibling filled", checks: sent({ ...base, evidence: { ...evidence, path: path.map((sibling, level) => (level === 0 ? evidence.salt : sibling)) } }) },
    { name: "a short path", checks: sent({ ...base, evidence: { ...evidence, path: path.slice(1) } }) },
    { name: "verdict the entry does not support", checks: sent({ ...base, claim: { ...base.claim, claimed: "excluded" } }) },
    { name: "claim stated as mismatch", checks: sent({ ...base, verdict: "mismatch" }) },
    { name: "no evidence", checks: sent({ ...base, evidence: null }) },
    { name: "a vacancy offered for a match", checks: sent({ ...base, evidence: absent.evidence }) },
    { name: "absence for a key the shop holds", checks: sentAbsent({ ...vacant, claim: present.claim }) },
    { name: "an entry offered for an absence", checks: sentAbsent({ ...vacant, evidence }) },
    { name: "absence with no proof", checks: sentAbsent({ ...vacant, evidence: null }) },
    { name: "the MRI key withheld", checks: [second, vacant] },
    { name: "both needed keys withheld", checks: [vacant] },
    { name: "only the needed keys", checks: [base, second] },
  ];
}

function summary(result: BuyerCheck): SiteResult {
  switch (result.status) {
    case "verified":
      return { status: "verified", verdict: result.verdict };
    case "unrequested":
      return { status: "unrequested", verdict: result.verified.verdict };
    case "withheld":
      return { status: "withheld", need: { topic: result.need.kind === "fact" ? result.need.topic : "" } };
    case "forged":
      return { status: "forged", forgery: result.forgery.kind };
    case "unproven":
      return { status: "unproven" };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

test("the browser verifier and grade reach the buyer's statuses and rating on honest and tampered evidence", async () => {
  const { question, needs } = siteEvidence();
  const root = hash(ON_CHAIN.insurance);
  const pinned = { status: "published", commitment: { scheme: "inferpay-keyed-merkle-sha256-v1", root, leaves: 3 }, source: { kind: "listing" } } as const;
  const statuses = new Set<string>();
  const ratings = new Set<string>();
  for (const { name, checks } of cases()) {
    const results = verifyChecks(checks, pinned, question, needs);
    const expected = results.map(summary);
    const actual = (await site.verifyChecks(checks, root, needs)).map(({ status, verdict, forgery, need }) => ({ status, verdict, forgery, need: need && { topic: need.topic } }));
    assert.deepEqual(actual, expected.map((item) => ({ verdict: undefined, forgery: undefined, need: undefined, ...item })), name);
    const rate = progressLine({ step: "rate", grade: grade(results), jobId: newJobId(1_700_000_000_000), onChain: null }, "mock").split("\n").slice(0, 5);
    assert.deepEqual(siteGrade.rateLines(siteGrade.grade(actual)), rate, name);
    for (const item of expected) statuses.add(`${item.status}:${item.verdict ?? item.forgery ?? item.need?.topic ?? ""}`);
    ratings.add(rate[0] ?? "");
  }
  assert.deepEqual([...statuses].sort(), [
    "forged:no-evidence",
    "forged:wrong-entry",
    "forged:wrong-root",
    "forged:wrong-verdict",
    "unproven:",
    "unrequested:absent",
    "verified:match",
    "withheld:mri-copay",
    "withheld:outpatient-mri",
  ]);
  assert.deepEqual([...ratings].sort(), [
    "rate      1/5  forged evidence sets the rating to 1",
    "rate      2/5  = 5 - 2 x 2 withheld = 1, and an honest delivery rates at least 2",
    "rate      3/5  = 5 - 2 x 1 withheld = 3",
    "rate      5/5  = 5",
  ]);
  const honest = cases()[0]?.checks[0];
  assert.ok(honest);
  assert.equal((await site.verifyFact(honest, flip(root, 0))).forgery, "wrong-root", "a different committed root");
});

test("the browser grade states the same rule as src/consumer/grade.ts", () => {
  assert.deepEqual(siteGrade.RULE, RULE);
});

test("the evidence the site embeds is what the generator makes from the sample data today", () => {
  assert.equal(readFileSync(EVIDENCE_MODULE, "utf8"), evidenceModule(), "run: node src/site/evidence.ts");
  assert.equal(siteEvidence().commitment.root, ON_CHAIN.insurance);
});
