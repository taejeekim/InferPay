import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createStubInference } from "./stub.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

test("routes a short Samsung operating-profit question through the recorded filing", async () => {
  const inference = createStubInference(fixtures);
  const result = await inference.run({
    name: "consumer.route",
    role: "consumer",
    system: "unused",
    input: "What was Samsung's Q3 2025 operating profit?",
    tools: [],
    parseOutput: (raw) => raw,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value, /disclosure/);
});

test("answers that short question from the recorded filing", async () => {
  const inference = createStubInference(fixtures);
  const result = await inference.run({
    name: "disclosure.answer",
    role: "provider",
    system: "unused",
    input: "What was Samsung's Q3 2025 operating profit?",
    tools: [],
    parseOutput: (raw, toolResults) => ({ raw, toolResults }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value.raw, /12\.1T/);
});

test("routes a legal question to the playbook agent", async () => {
  const inference = createStubInference(fixtures);
  const result = await inference.run({
    name: "consumer.route",
    role: "consumer",
    system: "unused",
    input: "Does this NDA's unlimited indemnification clause fail our playbook?",
    tools: [],
    parseOutput: (raw) => raw,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value, /legal/);
});

test("routes a coverage question to the insurance agent", async () => {
  const inference = createStubInference(fixtures);
  const result = await inference.run({
    name: "consumer.route",
    role: "consumer",
    system: "unused",
    input: "Does this policy cover an outpatient MRI?",
    tools: [],
    parseOutput: (raw) => raw,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value, /insurance/);
});
