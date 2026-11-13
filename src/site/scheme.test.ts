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
} from "../commitment/index.ts";
import type { Json } from "../commitment/merkle.ts";
import { verifyChecks } from "../consumer/verify.ts";
import { evidenceModule, EVIDENCE_MODULE, sampleDatasets, siteEvidence } from "./evidence.ts";

type SiteResult = { readonly status: string; readonly verdict?: string; readonly forgery?: string };

type SiteScheme = {
  canonical(value: unknown): string;
  entryKey(entry: Entry): Key;
  slotOf(key: Key): Promise<number>;
  leafHash(entry: Entry, salt: string): Promise<string | null>;
  opensTo(key: Key, evidence: unknown): Promise<string | null>;
  verifyFact(check: unknown, committed: string): Promise<SiteResult>;
};

const site = (await import(new URL("../../docs/js/scheme.js", import.meta.url).href)) as SiteScheme;

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

function cases(): readonly { readonly name: string; readonly check: FactCheck }[] {
  const { present, absent } = siteEvidence();
  const base: FactCheck = { kind: "fact", claim: present.claim, verdict: "match", evidence: present.evidence };
  const evidence = present.evidence;
  const path = evidence.path;
  const firstSibling = path.findIndex((sibling) => sibling !== null);
  const vacant: FactCheck = { kind: "fact", claim: absent.claim, verdict: "unverifiable", evidence: absent.evidence };
  return [
    { name: "honest match", check: base },
    { name: "value changed to excluded", check: { ...base, evidence: { ...evidence, entry: { ...evidence.entry, value: "excluded" } } } },
    { name: "source changed", check: { ...base, evidence: { ...evidence, entry: { ...evidence.entry, source: "made up" } } } },
    { name: "topic changed", check: { ...base, evidence: { ...evidence, entry: { ...evidence.entry, topic: "mri-copay" } } } },
    { name: "case of the topic changed", check: { ...base, evidence: { ...evidence, entry: { ...evidence.entry, topic: "Outpatient-MRI" } } } },
    ...[0, 17, 63].map((at) => ({ name: `salt flipped at ${at}`, check: { ...base, evidence: { ...evidence, salt: flip(evidence.salt, at) } } })),
    { name: "a non-empty sibling dropped", check: { ...base, evidence: { ...evidence, path: path.map((sibling, level) => (level === firstSibling ? null : sibling)) } } },
    { name: "an empty sibling filled", check: { ...base, evidence: { ...evidence, path: path.map((sibling, level) => (level === 0 ? evidence.salt : sibling)) } } },
    { name: "a short path", check: { ...base, evidence: { ...evidence, path: path.slice(1) } } },
    { name: "verdict the entry does not support", check: { ...base, claim: { ...base.claim, claimed: "excluded" } } },
    { name: "claim stated as mismatch", check: { ...base, verdict: "mismatch" } },
    { name: "no evidence", check: { ...base, evidence: null } },
    { name: "a vacancy offered for a match", check: { ...base, evidence: absent.evidence } },
    { name: "honest absence", check: vacant },
    { name: "absence for a key the shop holds", check: { ...vacant, claim: present.claim } },
    { name: "an entry offered for an absence", check: { ...vacant, evidence } },
    { name: "absence with no proof", check: { ...vacant, evidence: null } },
  ];
}

function summary(result: ReturnType<typeof verifyChecks>[number]): SiteResult {
  if (result.status === "verified") return { status: "verified", verdict: result.verdict };
  if (result.status === "forged") return { status: "forged", forgery: result.forgery.kind };
  return { status: "unproven" };
}

test("the browser verifier reaches the buyer's verdict on honest and tampered evidence", async () => {
  const root = hash(ON_CHAIN.insurance);
  const pinned = { status: "published", commitment: { scheme: "inferpay-keyed-merkle-sha256-v1", root, leaves: 3 }, source: { kind: "listing" } } as const;
  const statuses = new Set<string>();
  for (const { name, check } of cases()) {
    const expected = summary(verifyChecks([check], pinned, "")[0] as ReturnType<typeof verifyChecks>[number]);
    const actual = await site.verifyFact(check, root);
    assert.deepEqual({ status: actual.status, verdict: actual.verdict, forgery: actual.forgery }, { verdict: undefined, forgery: undefined, ...expected }, name);
    statuses.add(`${expected.status}:${expected.verdict ?? expected.forgery ?? ""}`);
  }
  assert.deepEqual([...statuses].sort(), [
    "forged:no-evidence",
    "forged:wrong-entry",
    "forged:wrong-root",
    "forged:wrong-verdict",
    "unproven:",
    "verified:absent",
    "verified:match",
  ]);
  const honest = cases()[0];
  assert.ok(honest);
  assert.equal((await site.verifyFact(honest.check, flip(root, 0))).forgery, "wrong-root", "a different committed root");
});

test("the evidence the site embeds is what the generator makes from the sample data today", () => {
  assert.equal(readFileSync(EVIDENCE_MODULE, "utf8"), evidenceModule(), "run: node src/site/evidence.ts");
  assert.equal(siteEvidence().commitment.root, ON_CHAIN.insurance);
});
