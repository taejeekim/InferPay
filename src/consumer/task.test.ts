import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.ts";
import { parseDecimalAmount, parseModelId } from "../domain.ts";
import type { Inference } from "../inference/index.ts";
import { createStubInference } from "../inference/stub.ts";
import { createRuntime } from "../runtime.ts";
import { percentOf, type Percent } from "./decide.ts";
import { createConsumerAgent } from "./index.ts";
import { nextAllotment, normaliseShares, parsePlan, splitBudget, type TaskOutcome } from "./task.ts";

test("the bases split the budget by share and sum to it exactly", () => {
  const cases: { budget: bigint; shares: number[]; bases: bigint[] }[] = [
    { budget: 100n, shares: [20, 20, 30, 30], bases: [20n, 20n, 30n, 30n] },
    { budget: 10n, shares: [33, 33, 34], bases: [3n, 3n, 4n] },
    { budget: 7n, shares: [50, 50], bases: [3n, 4n] },
    { budget: 1n, shares: [1, 99], bases: [0n, 1n] },
  ];
  for (const { budget, shares, bases } of cases) {
    assert.deepEqual(splitBudget(budget, shares.map(pct)), bases, `${budget} by ${shares.join("/")}`);
  }
});

test("a part's allotment is its base plus what earlier parts left unspent", () => {
  const bases = [20n, 20n, 30n, 30n];
  assert.equal(nextAllotment(bases, []), 20n);
  assert.equal(nextAllotment(bases, [0n]), 40n);
  assert.equal(nextAllotment(bases, [0n, 24n]), 46n);
  assert.equal(nextAllotment(bases, [0n, 24n, 20n]), 56n);
  assert.equal(nextAllotment(bases, [20n, 20n, 30n]), 30n);
  assert.throws(() => nextAllotment(bases, [50n]), /spent more than they were allotted/);
});

test("over every split and every spending pattern the task never pays more than its budget", () => {
  const budgets = [1n, 7n, 100n, 10n ** 17n, 123_456_789_012_345_678n];
  const splits = [[100], [50, 50], [33, 33, 34], [1, 1, 98], [20, 20, 30, 30], [10, 20, 30, 20, 20], [0, 0, 100]];
  // Each part spends this fraction of its allotment, in thousandths.
  const spendings = [[0], [1000], [500], [0, 1000], [1000, 0], [333, 999, 1], [1000, 1000, 1000, 1000, 1000]];
  let runs = 0;
  for (const budget of budgets) {
    for (const split of splits) {
      const bases = splitBudget(budget, split.map(pct));
      assert.equal(bases.reduce((sum, units) => sum + units, 0n), budget);
      for (const spending of spendings) {
        const spends: bigint[] = [];
        for (const [index, base] of bases.entries()) {
          const allotted = nextAllotment(bases, spends);
          assert.ok(allotted >= base, "carrying never shrinks a part below its own base");
          spends.push((allotted * BigInt(spending[index % spending.length] ?? 0)) / 1000n);
        }
        const total = spends.reduce((sum, units) => sum + units, 0n);
        assert.ok(total <= budget, `${budget} by ${split.join("/")} spending ${spending.join(",")}`);
        runs += 1;
      }
    }
  }
  assert.equal(runs, budgets.length * splits.length * spendings.length);
});

test("shares normalise to whole percents that sum to 100", () => {
  assert.deepEqual(normaliseShares([0.2, 0.2, 0.3, 0.3]), [20, 20, 30, 30]);
  assert.deepEqual(normaliseShares([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(normaliseShares([40, 40, 40]), [34, 33, 33]);
  assert.deepEqual(normaliseShares([3, 1]), [75, 25]);
});

test("a plan parses from fenced JSON and normalises shares that do not sum to 100", () => {
  const raw = [
    "Here is the plan.",
    "```json",
    '{"parts":[{"question":" What is   the capital of France? ","share":0.5},{"question":"Does this policy cover an outpatient MRI?","share":0.25}]}',
    "```",
  ].join("\n");
  assert.deepEqual(parsePlan(raw), [
    { question: "What is the capital of France?", share: 67 },
    { question: "Does this policy cover an outpatient MRI?", share: 33 },
  ]);
});

test("a plan with no parts, more than five, a share not above zero, or no JSON fails closed", () => {
  const part = (share: number) => ({ question: "What is the capital of France?", share });
  for (const raw of [
    JSON.stringify({ parts: [] }),
    JSON.stringify({ parts: Array.from({ length: 6 }, () => part(1)) }),
    JSON.stringify({ parts: [part(1), part(0)] }),
    JSON.stringify({ parts: [part(1), part(-1)] }),
    JSON.stringify({ parts: [{ question: "  ", share: 1 }] }),
    "Ask the insurance shop, then answer France yourself.",
  ]) {
    assert.equal(parsePlan(raw), null, raw);
  }
});

test("a part that fails is on the receipt and the parts after it still run", async () => {
  const plan = {
    parts: [
      { question: "What is the capital of Spain?", share: 0.5 },
      { question: "Does this policy cover an outpatient MRI?", share: 0.5 },
    ],
  };
  const { outcome, jobs } = await runWith(JSON.stringify(plan), "0.10");
  assert.equal(outcome.kind, "done");
  if (outcome.kind !== "done") return;
  const [first, second] = outcome.receipt.parts;
  assert.equal(first?.outcome.kind, "failed");
  assert.equal(first?.spent.amount, "0");
  assert.equal(second?.allotted.amount, "0.1", "the failed part's unspent half carries forward");
  assert.equal(second?.outcome.kind, "bought");
  assert.equal(outcome.receipt.spent.amount, "0.02");
  assert.equal(outcome.receipt.left.amount, "0.08");
  assert.equal(jobs.length, 1);
});

test("a plan that does not parse stops the task before any job or payment", async () => {
  const { outcome, jobs } = await runWith('{"parts":[]}', "0.10");
  assert.equal(outcome.kind, "unplanned");
  assert.deepEqual(jobs, []);
});

async function runWith(planReply: string, budget: string): Promise<{ outcome: TaskOutcome; jobs: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "inferpay-"));
  try {
    const config = loadConfig({ INFERPAY_DATA_DIR: root });
    assert.ok(config.ok);
    const { market } = await createRuntime(config.value);
    const amount = parseDecimalAmount(budget);
    assert.ok(amount);
    const outcome = await createConsumerAgent({ market, inference: planning(planReply) }).task(
      "a task the stub has no plan for",
      { budget: { ...config.value.near, amount }, buyer: config.value.roster.defaultBuyer },
    );
    const jobs = (await readdir(join(root, "jobs")).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
    return { outcome, jobs };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Replies with the given plan and replays the stub for everything else, so an unrecorded part fails as it would live.
function planning(raw: string): Inference {
  const stub = createStubInference();
  const model = parseModelId("fake");
  assert.ok(model);
  return {
    kind: "stub",
    attested: () => [],
    async run(task) {
      if (task.name !== "consumer.plan") return stub.run(task);
      const value = task.parseOutput(raw, []);
      if (value === null) return { ok: false, reason: "unparseable-output", detail: "output failed its check" };
      return { ok: true, value, model, attestation: [] };
    },
  };
}

function pct(value: number): Percent {
  const share = percentOf(value / 100);
  assert.ok(share !== null);
  return share;
}
