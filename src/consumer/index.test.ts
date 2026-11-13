import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.ts";
import { parseDecimalAmount, parseModelId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import { createRuntime } from "../runtime.ts";
import { createConsumerAgent, type Progress } from "./index.ts";

test("a malformed assessment stops the ask before any job or payment", async () => {
  for (const raw of ['{"answer":"Covered.","confidence":7,"coverage":{"insurance":1}}', "Buy from insurance."]) {
    const { outcome, steps, jobs } = await askWith(raw, "0.10");
    assert.equal(outcome.kind, "failed", raw);
    if (outcome.kind !== "failed") continue;
    assert.equal(outcome.reason.kind, "inference", raw);
    assert.deepEqual(steps, [], raw);
    assert.deepEqual(jobs, [], raw);
  }
});

test("the buyer counters at its reservation and pays the price the shop agreed to", async () => {
  const raw = '{"answer":"Probably.","confidence":0.2,"missing":["the policy"],"coverage":{"insurance":1}}';
  const { outcome, steps, jobs } = await askWith(raw, "0.03");
  assert.deepEqual(steps, ["decide", "pay", "answer", "rate"]);
  assert.equal(outcome.kind, "outsourced");
  if (outcome.kind !== "outsourced") return;
  assert.equal(outcome.job.providerId, "insurance");
  assert.equal(outcome.job.paid.amount.amount, "0.015");
  assert.equal(jobs.length, 1);
});

async function askWith(raw: string, budget: string) {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    const config = loadConfig({ INFERPAY_DATA_DIR: root });
    assert.ok(config.ok);
    const { market } = await createRuntime(config.value);
    const amount = parseDecimalAmount(budget);
    assert.ok(amount);
    const steps: Progress["step"][] = [];
    const outcome = await createConsumerAgent({ market, inference: replying(raw) }).ask(
      "Does this policy cover an outpatient MRI?",
      { budget: { ...config.value.near, amount }, buyer: config.value.roster.defaultBuyer },
      (progress) => steps.push(progress.step),
    );
    const jobs = (await readdir(join(root, "jobs")).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
    return { outcome, steps, jobs };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function replying(raw: string): Inference {
  const model = parseModelId("fake");
  assert.ok(model);
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
