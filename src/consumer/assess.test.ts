import assert from "node:assert/strict";
import test from "node:test";
import { parseModelId, parseProviderId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import { assess } from "./assess.ts";

const SHOPS = [
  {
    id: must(parseProviderId("insurance")),
    routingHint: "Private policy schedule.",
    catalog: [{ kind: "fact" as const, topic: "outpatient-mri" }, { kind: "fact" as const, topic: "mri-copay" }],
    commitment: { status: "published" as const },
  },
  {
    id: must(parseProviderId("legal")),
    routingHint: "Private clause playbook.",
    catalog: [{ kind: "rule" as const, id: "uncapped-indemnity" }],
    commitment: { status: "published" as const },
  },
];

test("a shop with no commitment the buyer can read gets no needed key and so no coverage, whatever the model said", async () => {
  const raw = '{"answer":"Probably covered.","confidence":0.2,"coverage":{"insurance":0.9},"needs":{"insurance":[{"key":"outpatient-mri"}]}}';
  const shops = SHOPS.map((shop) => (shop.id === "insurance" ? { ...shop, commitment: { status: "missing" as const } } : shop));
  const result = await assess(replying(raw), "Does this policy cover an outpatient MRI?", shops);
  assert.ok(result.ok);
  assert.deepEqual([...result.assessment.coverage], []);
  assert.deepEqual([...result.needs.byShop], []);
  assert.deepEqual(result.needs.dropped, [{ shop: "insurance", key: "outpatient-mri", why: "no-commitment" }]);
});

test("an assessment survives a code fence and surrounding prose", async () => {
  const raw = [
    "Here is my assessment.",
    "```json",
    '{"answer":" Probably\\ncovered. ","confidence":0.2,"missing":["the policy\\n  schedule"," "],"coverage":{"insurance":0.9,"legal":0,"unlisted":1},"needs":{"insurance":[{"key":"outpatient-mri"}]}}',
    "```",
  ].join("\n");
  const result = await assess(replying(raw), "Does this policy cover an outpatient MRI?", SHOPS);
  assert.ok(result.ok);
  assert.equal(result.assessment.answer, "Probably covered.");
  assert.equal(result.assessment.confidence, 20);
  assert.deepEqual(result.assessment.missing, ["the policy schedule"]);
  assert.deepEqual([...result.assessment.coverage], [["insurance", 90]]);
  assert.deepEqual([...result.needs.byShop], [["insurance", [{ kind: "fact", topic: "outpatient-mri" }]]]);
});

test("needs outside a shop's catalog are dropped, and a shop left with no needs covers nothing", async () => {
  const raw = JSON.stringify({
    answer: "Probably covered.",
    confidence: 0.2,
    coverage: { insurance: 1, legal: 0.5 },
    needs: {
      insurance: [{ key: " MRI-Copay " }, { key: "dental" }, { key: "mri-copay" }],
      legal: [{ key: "uncapped-indemnity", clause: "a clause nobody quoted" }, { key: "uncapped-indemnity" }],
    },
  });
  const result = await assess(replying(raw), "What does this policy charge for an MRI?", SHOPS);
  assert.ok(result.ok);
  assert.deepEqual([...result.needs.byShop], [["insurance", [{ kind: "fact", topic: "mri-copay" }]]]);
  assert.deepEqual(result.needs.dropped, [
    { shop: "insurance", key: "dental", why: "not-in-catalog" },
    { shop: "legal", key: "uncapped-indemnity", why: "clause-not-quoted" },
    { shop: "legal", key: "uncapped-indemnity", why: "clause-not-quoted" },
  ]);
  assert.deepEqual([...result.assessment.coverage], [["insurance", 100]]);
});

test("a rule need carries the clause it is to be tested against, quoted from the question", async () => {
  const question = "Does this NDA's unlimited indemnification clause fail our playbook?";
  const raw = JSON.stringify({
    answer: "Probably.",
    confidence: 0.1,
    coverage: { legal: 1 },
    needs: { legal: [{ key: "uncapped-indemnity", clause: "Unlimited  indemnification clause" }] },
  });
  const result = await assess(replying(raw), question, SHOPS);
  assert.ok(result.ok);
  assert.deepEqual(result.needs.byShop.get(must(parseProviderId("legal"))), [
    { kind: "rule", id: "uncapped-indemnity", clause: "Unlimited indemnification clause" },
  ]);
});

test("an assessment may leave out what is missing and who covers it", async () => {
  const result = await assess(replying('{"answer":"Paris.","confidence":0.99}'), "What is the capital of France?", SHOPS);
  assert.ok(result.ok);
  assert.deepEqual(result.assessment.missing, []);
  assert.equal(result.assessment.coverage.size, 0);
});

test("a malformed assessment is rejected", async () => {
  const malformed: readonly (readonly [string, string])[] = [
    ["prose only", "I am quite sure the answer is yes."],
    ["broken JSON", '{"answer":"yes","confidence":0.9'],
    ["no answer", '{"answer":"  ","confidence":0.9}'],
    ["no confidence", '{"answer":"yes"}'],
    ["confidence as a word", '{"answer":"yes","confidence":"high"}'],
    ["confidence as a percent", '{"answer":"yes","confidence":85}'],
    ["negative confidence", '{"answer":"yes","confidence":-0.1}'],
    ["coverage above one", '{"answer":"yes","confidence":0.2,"coverage":{"insurance":1.5}}'],
    ["coverage as a word", '{"answer":"yes","confidence":0.2,"coverage":{"insurance":"full"}}'],
    ["missing as a string", '{"answer":"yes","confidence":0.2,"missing":"the policy"}'],
  ];
  for (const [name, raw] of malformed) {
    const result = await assess(replying(raw), "anything", SHOPS);
    assert.equal(result.ok, false, name);
  }
});

function replying(raw: string): Inference {
  const model = must(parseModelId("fake"));
  return {
    kind: "near-ai",
    async run(task) {
      const value = task.parseOutput(raw, []);
      if (value === null) return { ok: false, reason: "unparseable-output", detail: "output failed its check" };
      return { ok: true, value, model, attestation: [] };
    },
    attested: () => [],
  };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
