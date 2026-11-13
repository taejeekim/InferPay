import assert from "node:assert/strict";
import test from "node:test";
import { parseModelId, parseProviderId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import { assess } from "./assess.ts";

const SHOPS = [
  { id: must(parseProviderId("insurance")), routingHint: "Private policy schedule." },
  { id: must(parseProviderId("legal")), routingHint: "Private clause playbook." },
];

test("an assessment survives a code fence and surrounding prose", async () => {
  const raw = [
    "Here is my assessment.",
    "```json",
    '{"answer":" Probably covered. ","confidence":0.2,"missing":["the policy schedule"," "],"coverage":{"insurance":0.9,"legal":0,"unlisted":1}}',
    "```",
  ].join("\n");
  const result = await assess(replying(raw), "Does this policy cover an outpatient MRI?", SHOPS);
  assert.ok(result.ok);
  assert.equal(result.assessment.answer, "Probably covered.");
  assert.equal(result.assessment.confidence, 20);
  assert.deepEqual(result.assessment.missing, ["the policy schedule"]);
  assert.deepEqual([...result.assessment.coverage], [["insurance", 90], ["legal", 0]]);
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
      return { ok: true, value, model };
    },
  };
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("fixture");
  return value;
}
