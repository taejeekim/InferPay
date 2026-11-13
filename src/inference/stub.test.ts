import assert from "node:assert/strict";
import { test } from "node:test";
import { createStubInference } from "./stub.ts";

function assess(input: string) {
  return createStubInference().run({
    name: "consumer.assess",
    role: "consumer",
    system: "unused",
    input,
    tools: [],
    parseOutput: (raw) => raw,
  });
}

test("matches a recorded question across case, spacing, and trailing punctuation", async () => {
  for (const variant of [
    "  what was samsung's   q3 2025 OPERATING PROFIT  ",
    "What was Samsung's Q3 2025 operating profit",
    "What was Samsung's Q3 2025 operating profit?!",
  ]) {
    const result = await assess(variant);
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
  for (const question of ["Schedule a meeting on Monday", "Is Apple revenue up?", "What is the capital of Peru?"]) {
    const result = await assess(question);
    assert.equal(result.ok, false, question);
    if (result.ok) continue;
    assert.equal(result.reason, "no-fixture");
    assert.match(result.detail, /No NEAR moved/);
    assert.match(result.detail, /NEAR_AI_API_KEY/);
    assert.match(result.detail, /npx inferpay ask "Does this policy cover cosmetic surgery\?" --budget 0\.10/);
  }
});
