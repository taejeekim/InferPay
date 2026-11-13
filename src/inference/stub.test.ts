import assert from "node:assert/strict";
import { test } from "node:test";
import { createStubInference } from "./stub.ts";

function route(input: string) {
  return createStubInference().run({
    name: "consumer.route",
    role: "consumer",
    system: "unused",
    input,
    tools: [],
    parseOutput: (raw) => raw,
  });
}

test("routes each README question to its provider", async () => {
  const expected: readonly (readonly [string, RegExp])[] = [
    ["What was Samsung's Q3 2025 operating profit?", /disclosure/],
    ["Does this NDA's unlimited indemnification clause fail our playbook?", /legal/],
    ["Does this policy cover an outpatient MRI?", /insurance/],
    ["Does this policy cover cosmetic surgery?", /insurance/],
  ];
  for (const [question, provider] of expected) {
    const result = await route(question);
    assert.equal(result.ok, true, question);
    if (result.ok) assert.match(result.value, provider);
  }
});

test("matches a recorded question across case, spacing, and trailing punctuation", async () => {
  for (const variant of [
    "  what was samsung's   q3 2025 OPERATING PROFIT  ",
    "What was Samsung's Q3 2025 operating profit",
    "What was Samsung's Q3 2025 operating profit?!",
  ]) {
    const result = await route(variant);
    assert.equal(result.ok, true, variant);
  }
});

test("answers the paid question from the same recording", async () => {
  const result = await createStubInference().run({
    name: "disclosure.answer",
    role: "provider",
    system: "unused",
    input: "What was Samsung's Q3 2025 operating profit?",
    tools: [],
    parseOutput: (raw) => raw,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.value, /12\.2T/);
});

test("an unrecorded question fails and says nothing was spent", async () => {
  for (const question of ["Schedule a meeting on Monday", "Is Apple revenue up?", "What is the capital of France?"]) {
    const result = await route(question);
    assert.equal(result.ok, false, question);
    if (result.ok) continue;
    assert.equal(result.reason, "no-fixture");
    assert.match(result.detail, /No NEAR moved/);
    assert.match(result.detail, /NEAR_AI_API_KEY/);
    assert.match(result.detail, /npx inferpay ask "Does this policy cover cosmetic surgery\?" --budget 0\.10/);
  }
});
